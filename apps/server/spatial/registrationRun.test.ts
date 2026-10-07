import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SURFACE, type OverlayLine } from '@hubble/stage'
import type { LidarFrame } from '@hubble/room'
import { createSpatialService, type SpatialService, type SpatialTouchEvent } from './service.ts'
import { createRegistrationRun, registrationTargets, REGISTRATION_LAYER, type RegistrationRun } from './registrationRun.ts'
import { tableToSensor, wireFrames, withFinger } from './lidarFixtures.ts'

/*
 * The lidar registration run end to end (#89 T4, docs/plans/2026-10-07-lidar-web.md):
 * a loopback socket streams the real wire rotations (recording); the "person"
 * is a pump that puts a fingertip (mechanical mutation) on whichever target the
 * run has lit, and lifts it when the run says so. The lidar pose is the
 * schema-derived one in lidarFixtures (not a measurement). Oracles: target px ×
 * the Surface's mm/px, and that pose, computed here.
 */
const frames = wireFrames()
const mmPerPx = DEFAULT_SURFACE.mmPerPx
const all = (() => {
  const t = registrationTargets()
  return [...t.fit, ...t.check]
})()
const sensorOf = (px: { x: number; y: number }) => tableToSensor({ x: px.x * mmPerPx, y: px.y * mmPerPx })

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

async function rig(o: { mayProject?: boolean; offsetCheckMm?: number } = {}) {
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const service: SpatialService = createSpatialService({ lidarUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  const [socket] = (await once(server, 'connection')) as [WebSocket]
  let t = Date.now()
  const send = (f: LidarFrame) => socket.send(JSON.stringify({ t: (t += 100), points: f.points }))
  const overlays: OverlayLine[] = []
  const run: RegistrationRun = createRegistrationRun({
    spatial: service,
    overlay: (l) => overlays.push(l),
    mayProject: () => o.mayProject ?? true,
    captureMs: 300,
    liftMs: 200,
  })
  // The person: a finger on the lit target while the run captures, none while
  // it waits for a lift. A check target can be deliberately misplaced.
  let i = 0
  let pumping = true
  const pump = setInterval(() => {
    if (!pumping) return
    const f = frames[40 + (i++ % 70)]!
    const st = run.state()
    if (st.phase === 'capturing') {
      const target = all[st.index]!
      const off = st.index >= 9 ? (o.offsetCheckMm ?? 0) : 0
      const s = sensorOf(target)
      send(withFinger(f, { x: s.x + off, y: s.y }))
    } else send(f)
  }, 25)
  cleanup = async () => {
    pumping = false
    clearInterval(pump)
    run.cancel()
    service.stop()
    for (const ws of server.clients) ws.terminate()
    await new Promise<void>((r) => server.close(() => r()))
  }
  // The baseline from empty rotations (the pump sends empty frames while idle).
  const b = await service.captureBaseline(1000)
  expect(b).toMatchObject({ ok: true })
  return { service, run, overlays, send, stopPump: () => { pumping = false } }
}

const until = async (cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('lidar registration run', () => {
  // Break caught: the whole T4 chain (target → held-finger capture → pair →
  // fit → saved registration) not producing a map that puts a later finger
  // where it is on the projection.
  it('twelve held fingers → a saved registration that maps a new touch to the right pixel', async () => {
    const { service, run, send, stopPump } = await rig()
    expect(run.start()).toMatchObject({ ok: true })
    await until(() => ['done', 'failed'].includes(run.state().phase))
    const st = run.state()
    expect(st.phase, st.message).toBe('done')
    expect(st.result!.heldOutMaxMm).toBeLessThan(5)
    expect(service.calibration.snapshot().registration).not.toBeNull()
    // A touch at a point the fit never saw, projector (1200, 800): it must
    // come out at that pixel through the saved map (oracle: the pose).
    stopPump()
    const touches: SpatialTouchEvent[] = []
    service.onTouch((e) => touches.push(e))
    const at = { x: 1200, y: 800 }
    for (let k = 0; k < 3; k++) {
      send(withFinger(frames[60 + k]!, sensorOf(at)))
      await new Promise((r) => setTimeout(r, 30))
    }
    const down = touches.find((e) => e.type === 'down')
    expect(down, JSON.stringify(touches)).toBeDefined()
    expect(Math.hypot(down!.projector!.x - at.x, down!.projector!.y - at.y)).toBeLessThan(10)
  }, 30_000)

  // Break caught: a fit with a bad held-out point being saved (Ruling 4: the
  // held-out targets check the map; past 22 mm it's refused, not saved).
  it('a misplaced check finger: the fit is refused and nothing is saved', async () => {
    const { service, run } = await rig({ offsetCheckMm: 60 })
    run.start()
    await until(() => ['done', 'failed'].includes(run.state().phase))
    expect(run.state()).toMatchObject({ phase: 'failed', message: expect.stringMatching(/refused/) })
    expect(service.calibration.snapshot().registration).toBeNull()
  }, 30_000)

  // Break caught: targets drawn on the shared projector without the owner's arm.
  it('without the arm: refused, and nothing is drawn', async () => {
    const { run, overlays } = await rig({ mayProject: false })
    expect(run.start()).toMatchObject({ ok: false, error: expect.stringMatching(/arm/) })
    expect(overlays.filter((l) => l.layer === REGISTRATION_LAYER)).toEqual([])
  })

  // Break caught: a cancelled run leaving its target lit on the table.
  it('cancel clears the targets', async () => {
    const { run, overlays } = await rig()
    run.start()
    await until(() => overlays.some((l) => l.layer === REGISTRATION_LAYER && l.shapes.length > 0))
    run.cancel()
    expect(overlays.filter((l) => l.layer === REGISTRATION_LAYER).at(-1)!.shapes).toEqual([])
    expect(run.state().phase).toBe('cancelled')
  })
})

describe('lidar registration run: the lift', () => {
  // Break caught: the run moving to the next target while the finger is still
  // resting where it was, so target 2 is captured at target 1's position (a
  // bad pair the person never notices). Stub spatial service: captures of the
  // capture length always see a finger; lift checks see it twice more, then
  // none. Oracle: the order of calls, written here.
  it('waits for the finger to lift before lighting the next target', async () => {
    const calls: string[] = []
    let liftChecks = 0
    const stub = {
      calibration: { register: () => undefined, lidarToTable: () => null, snapshot: () => ({ registration: null }) },
      captureFinger: async (ms: number) => {
        calls.push(ms === 300 ? 'capture' : 'lift')
        if (ms === 300) return { ok: true as const, sensor: { x: 0, y: 500 }, rotations: 10, hits: 10, spreadMm: 1 }
        return liftChecks++ < 2
          ? { ok: true as const, sensor: { x: 0, y: 500 }, rotations: 4, hits: 4, spreadMm: 1 }
          : { ok: false as const, reason: 'no-finger' as const, detail: '', rotations: 4 }
      },
    }
    const run = createRegistrationRun({ spatial: stub as never, overlay: () => {}, mayProject: () => true, captureMs: 300, liftMs: 200 })
    run.start()
    await until(() => calls.filter((c) => c === 'capture').length >= 2)
    run.cancel()
    expect(calls.slice(0, 5)).toEqual(['capture', 'lift', 'lift', 'lift', 'capture'])
  })
})
