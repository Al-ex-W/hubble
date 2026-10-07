import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { apply, createPiRoom, windowAt, WINDOW_MINUTES, WINDOW_START_MINUTE, type H, type HardwareWindow } from '@hubble/room'
import type { OverlayLine } from '@hubble/stage'
import { describe, expect, it } from 'vitest'
import { createApp } from '../index.ts'
import { createRuntime } from '../runtime.ts'
import { REFERENCE_REFRESH_MS } from '../../shared/markers/layout.ts'
import { createReferenceRun } from './reference.ts'
import { createSpatialService } from './service.ts'
import { inverse } from './coordinates.ts'

/**
 * The reference run and the markers route (#91).
 *
 * Frames: `fixtures/markers-2026-10-07/` (mechanical mutation of the
 * recorded room frame; see markers.test.ts). Oracle: the manifest's true
 * camera map and anchor positions, never the localizer's own output.
 */
const dir = new URL('../fixtures/markers-2026-10-07/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'))
const jpeg = (name: string) => new Uint8Array(readFileSync(new URL(`${name}.jpg`, dir)))
const truth = manifest.frames.find((f: { name: string }) => f.name === 'projected-physical').cameraToTable as H

const worst = (fitted: H) => {
  const toCamera = inverse(truth)!
  return Math.max(...manifest.projected.map((m: { corners: { x: number; y: number }[] }) => {
    const c = { x: (m.corners[0]!.x + m.corners[2]!.x) / 2, y: (m.corners[0]!.y + m.corners[2]!.y) / 2 }
    const p = apply(fitted, apply(toCamera, c))
    return Math.hypot(p.x - c.x, p.y - c.y)
  }))
}
const until = async (cond: () => boolean, ms = 20_000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('a reference run', () => {
  it('projects the grid, localizes the room camera, learns the printed anchors, then clears', async () => {
    // Break caught: the run's frames never reaching the localizer (the map
    // stays the dot calibration's), anchors not saved at the end, or the
    // grid left on the shared projector after the run.
    const spatial = createSpatialService()
    const overlays: OverlayLine[] = []
    let grabs = 0
    const run = createReferenceRun({
      overlay: (l) => overlays.push(l),
      spatial,
      frame: async () => (grabs++, jpeg('projected-physical')),
      mayProject: () => true,
      settleMs: 0,
      durationMs: 60_000,
    })
    expect(run.start().ok).toBe(true)
    expect(overlays[0]!.layer).toBe('reference')
    expect(overlays[0]!.shapes.length).toBeGreaterThan(12 * 2)
    await until(() => spatial.calibration.cameraFor('room') !== null && grabs >= 4)
    run.stop()
    expect(worst(spatial.calibration.cameraFor('room')!.h)).toBeLessThan(2)
    expect(overlays.at(-1)).toEqual({ kind: 'overlay', layer: 'reference', shapes: [] })
    const anchors = spatial.localization().anchors!.markers
    for (const a of manifest.anchors as { id: number; x: number; y: number }[]) {
      const c = anchors[String(a.id)]!
      expect(Math.hypot((c[0].x + c[2].x) / 2 - a.x, (c[0].y + c[2].y) / 2 - a.y)).toBeLessThan(2)
    }
    // After the run, projected ids stop counting: only the anchors remain.
    expect(spatial.localization().targets.sort((x, y) => x - y)).toEqual([40, 41, 42, 43])
    spatial.stop()
  })

  it('refuses to project when the room output is not armed', () => {
    // Break caught: the owner's rule skipped. Projecting is a projector
    // write on a projector the organisers and other teams share.
    const spatial = createSpatialService()
    const overlays: OverlayLine[] = []
    const run = createReferenceRun({ overlay: (l) => overlays.push(l), spatial, frame: null, mayProject: () => false })
    const r = run.start()
    expect(r.ok).toBe(false)
    expect(overlays).toEqual([])
    expect(spatial.localization().projecting).toBe(false)
    spatial.stop()
  })

  it('clears itself after its duration, and runs one at a time', async () => {
    // Break caught (1): no timer, so a forgotten run leaves 12 markers on
    // the table through the demo. Break caught (2): a second press starting
    // a parallel run whose clear() wipes the first one's grid mid-run.
    const spatial = createSpatialService()
    const overlays: OverlayLine[] = []
    const run = createReferenceRun({ overlay: (l) => overlays.push(l), spatial, frame: null, mayProject: () => true, durationMs: 30 })
    expect(run.start().ok).toBe(true)
    expect(run.start().ok).toBe(false)
    expect(spatial.localization().projecting).toBe(true)
    await until(() => !run.state().on)
    expect(overlays.at(-1)!.shapes).toEqual([])
    expect(spatial.localization().projecting).toBe(false)
    spatial.stop()
  })
})

// A Stockholm wall-clock instant at hh:mm:ss on 7 Oct 2026 (CEST, UTC+2).
// The window's own windowAt() reads it, so the edges are window.ts's, never
// minutes copied here: the test follows the owner's next move of the window.
const at = (minute: number, second = 0) => Date.UTC(2026, 9, 7, 10, minute, second)
const windowClock = (clock: () => number) => () => windowAt(clock())

describe('a reference run and the hardware window (review of #95, finding 2)', () => {
  it('is refused while the window is shut, on the real room', () => {
    // Break caught: the grid reaching the shared projector outside our 20
    // minutes. It goes out over SSE to a page the Pi loaded from us, so the
    // device pool, which only sees connections WE open, never stops it.
    const spatial = createSpatialService()
    const overlays: OverlayLine[] = []
    const shut = at(WINDOW_START_MINUTE + WINDOW_MINUTES + 5)
    const run = createReferenceRun({ overlay: (l) => overlays.push(l), spatial, frame: null, mayProject: () => true, window: windowClock(() => shut), now: () => shut })
    const r = run.start()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/hardware window/)
    expect(overlays).toEqual([])
    expect(spatial.localization().projecting).toBe(false)
    spatial.stop()
  })

  it('ends at the window close when it starts just before it', async () => {
    // Break caught: the run's 12 s duration carrying it past n:30. Started
    // 200 ms before the close, it must be off the table at the close, long
    // before its own duration ends.
    const spatial = createSpatialService()
    const overlays: OverlayLine[] = []
    let t0 = Date.now()
    const close = at(WINDOW_START_MINUTE + WINDOW_MINUTES)
    const clock = () => close - 200 + (Date.now() - t0)
    const run = createReferenceRun({ overlay: (l) => overlays.push(l), spatial, frame: null, mayProject: () => true, window: windowClock(clock), now: clock, durationMs: 60_000 })
    t0 = Date.now() // the clock starts here: building the detector takes tens of ms
    const started = run.start()
    expect(started.ok, started.error).toBe(true)
    await until(() => !run.state().on, 2000)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(overlays.at(-1)!.shapes).toEqual([])
    spatial.stop()
  })

  it('ends when the window shuts under it, even if the close timer was missed', async () => {
    // Break caught: only the start-time timer guarding the close. A clock
    // that jumps (laptop sleep, NTP step) skips it; the refresh tick must
    // see the shut window and end the run instead of re-sending the grid.
    const spatial = createSpatialService()
    const overlays: OverlayLine[] = []
    let w: HardwareWindow = { open: true, opensAt: Date.now(), closesAt: Date.now() + 3_600_000 }
    const run = createReferenceRun({ overlay: (l) => overlays.push(l), spatial, frame: null, mayProject: () => true, window: () => w, durationMs: 60_000 })
    expect(run.start().ok).toBe(true)
    w = { open: false, opensAt: Date.now() + 3_600_000, closesAt: Date.now() }
    await until(() => !run.state().on, REFERENCE_REFRESH_MS * 3)
    expect(overlays.at(-1)!.shapes).toEqual([])
    spatial.stop()
  }, 10_000)

  it('re-sends the grid while on, as the display lease needs', async () => {
    // Break caught: no refresh. The display drops the grid after its TTL
    // (OverlayLayer.tsx), so a run without refreshes would vanish after 5 s
    // and the 12 s run would localize from frames without markers.
    const spatial = createSpatialService()
    const overlays: OverlayLine[] = []
    const run = createReferenceRun({ overlay: (l) => overlays.push(l), spatial, frame: null, mayProject: () => true, durationMs: 60_000 })
    run.start()
    await until(() => overlays.length >= 2, REFERENCE_REFRESH_MS * 3)
    expect(overlays[1]!.shapes.length).toBe(overlays[0]!.shapes.length)
    run.stop()
    spatial.stop()
  }, 10_000)
})

describe('a reference run and the runtime (review of #95, finding 3)', () => {
  const setup = () => {
    // Loopback stand-in Pis: never a room device (AGENTS.md).
    const room = createPiRoom({ hosts: { table: 'http://127.0.0.1:9', 'tv-1': 'http://127.0.0.1:9', 'tv-2': 'http://127.0.0.1:9', hue: 'http://127.0.0.1:9' }, lidarPose: { x: 775, y: 0, rotation: 90 } })
    const overlays: OverlayLine[] = []
    const runtime = createRuntime({
      overlay: (l) => overlays.push(l), room, requireArm: true, autoTick: false, calibrationFile: '/nonexistent/c.json',
      hardwareWindow: () => ({ open: true, opensAt: Date.now(), closesAt: Date.now() + 3_600_000 }),
      // Never fetch a frame: the settle outlasts the test.
      cameraFrame: () => new Promise<Uint8Array>(() => {}), calibrationSettleMs: 60_000,
    })
    const reference = overlays.filter.bind(overlays)
    return { runtime, overlays, last: () => reference((l) => l.layer === 'reference').at(-1) }
  }

  it('ends the run on disarm', () => {
    // Break caught: disarm stopping only LATER writes while the grid stays
    // on the shared projector for the rest of its run.
    const { runtime, last } = setup()
    expect(runtime.reference(true).ok).toBe(false) // unarmed: refused
    runtime.arm(true)
    expect(runtime.reference(true).ok).toBe(true)
    expect(last()!.shapes.length).toBeGreaterThan(0)
    runtime.arm(false)
    expect(runtime.referenceState().on).toBe(false)
    expect(last()!.shapes).toEqual([])
    runtime.stop()
  })

  it('ends the run on runtime.stop()', () => {
    // Break caught: a server shutting down with the run's timers alive and
    // the grid drawn; the last thing the displays got was the grid.
    const { runtime, last } = setup()
    runtime.arm(true)
    expect(runtime.reference(true).ok).toBe(true)
    runtime.stop()
    expect(runtime.referenceState().on).toBe(false)
    expect(last()!.shapes).toEqual([])
  })

  it('reads the window on the real room: shut window, armed, still refused', () => {
    // Break caught: the runtime not passing the window to the run (the gate
    // above exists but is never wired), so on the real room only the arm
    // would guard the projector.
    const room = createPiRoom({ hosts: { table: 'http://127.0.0.1:9', 'tv-1': 'http://127.0.0.1:9', 'tv-2': 'http://127.0.0.1:9', hue: 'http://127.0.0.1:9' }, lidarPose: { x: 775, y: 0, rotation: 90 } })
    const runtime = createRuntime({ overlay: () => {}, room, requireArm: true, autoTick: false, calibrationFile: '/nonexistent/c.json', hardwareWindow: () => ({ open: false, opensAt: Date.now() + 1000, closesAt: 0 }) })
    runtime.arm(true)
    const r = runtime.reference(true)
    expect(r.ok).toBe(false)
    expect((r as { error?: string }).error).toMatch(/hardware window/)
    runtime.stop()
  })
})

describe('the markers route', () => {
  it('validates, localizes, and refuses a replayed frame', async () => {
    // Break caught: an unvalidated body reaching the fit (any id, any
    // number of markers), or a replayed frame voting twice in the smoothing.
    const app = createApp({ port: 0, llm: { baseUrl: 'http://unused', apiKey: undefined, model: 'unused' }, jevApiKey: undefined })
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    try {
      const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
      const frame = { source: 'ipad', session: 's', seq: 1, geometry: 'ipad:1280x720', width: 1280, height: 720, markers: [{ id: 40, corners }] }
      expect((await post('/api/spatial/markers', { ...frame, source: 'phone' })).status).toBe(400)
      expect((await post('/api/spatial/markers', { ...frame, markers: [{ id: 40, corners: corners.slice(0, 3) }] })).status).toBe(400)
      expect((await post('/api/spatial/markers', { ...frame, markers: Array(33).fill({ id: 40, corners }) })).status).toBe(400)
      const ok = await post('/api/spatial/markers', frame)
      expect(ok.status).toBe(202)
      expect(((await ok.json()) as { last: { ok: boolean } }).last.ok).toBe(false)
      expect((await post('/api/spatial/markers', frame)).status).toBe(409)
      expect((await post('/api/spatial/reference', { on: 'yes' })).status).toBe(400)
      const print = await fetch(`${base}/api/spatial/markers/print`)
      expect(print.headers.get('content-type')).toContain('image/svg+xml')
      expect(await print.text()).toContain('width="210mm"')
    } finally {
      server.close()
      app.spatial.stop()
    }
  })
})
