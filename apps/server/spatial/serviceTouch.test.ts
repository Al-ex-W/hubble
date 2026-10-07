import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SURFACE } from '@hubble/stage'
import type { LidarFrame } from '@hubble/room'
import { createSpatialService, type SpatialService, type SpatialTouchEvent } from './service.ts'
import { tableToSensor, wireFrames, withFinger } from './lidarFixtures.ts'
import { touchLineFor } from '../touchLines.ts'

/*
 * The spatial service's lidar touch end to end (#89): a loopback socket (the
 * device pool never gates loopback) streams the real wire rotations
 * (recording), fingers are put in by mechanical mutation, and the
 * registration is schema-derived (lidar 30 mm behind the back edge's middle;
 * table mm → projector px by the Surface's mm/px). Oracles: plain arithmetic
 * on those definitions, never the service's own maps.
 */
const frames = wireFrames()
const mmPerPx = DEFAULT_SURFACE.mmPerPx

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

async function rig() {
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const service = createSpatialService({ lidarUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  const [socket] = (await once(server, 'connection')) as [WebSocket]
  let t = Date.now()
  // The Pi's wire format: {t, points}. t must progress or the source drops it.
  const send = (f: LidarFrame) => socket.send(JSON.stringify({ t: (t += 100), points: f.points }))
  const touches: SpatialTouchEvent[] = []
  service.onTouch((e) => touches.push(e))
  cleanup = async () => {
    service.stop()
    for (const ws of server.clients) ws.terminate()
    await new Promise<void>((r) => server.close(() => r()))
  }
  return { service, send, touches, socket }
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function register(service: SpatialService) {
  // Schema-derived: four fit + two check targets, distinct, from the pose definition.
  const tablePts = [{ x: 100, y: 100 }, { x: 1450, y: 100 }, { x: 1450, y: 870 }, { x: 100, y: 870 }]
  const tableCheck = [{ x: 775, y: 485 }, { x: 400, y: 600 }]
  const toPx = (p: { x: number; y: number }) => ({ x: p.x / mmPerPx, y: p.y / mmPerPx })
  service.calibration.register({
    table: tablePts.map((p) => ({ from: p, to: toPx(p) })),
    tableCheck: tableCheck.map((p) => ({ from: p, to: toPx(p) })),
    lidar: tablePts.map((p) => ({ from: tableToSensor(p), to: p })),
    lidarCheck: tableCheck.map((p) => ({ from: tableToSensor(p), to: p })),
    maxProjectorErrorPx: 1,
    maxTableErrorMm: 1,
  })
}

async function baselined() {
  const r = await rig()
  register(r.service)
  // The real lidar never pauses: keep rotations coming (every 25 ms, the
  // first 40 recorded ones, cycling) for the whole capture, as the Pi would.
  let i = 0
  const pump = setInterval(() => r.send(frames[i++ % 40]), 25)
  const result = await r.service.captureBaseline(1000)
  clearInterval(pump)
  expect(result).toMatchObject({ ok: true })
  return r
}

describe('spatial service: lidar touch', () => {
  // Break caught: touch reported as enabled before it can work. The frame's
  // touchEnabled must say why it's off until all three exist.
  it('touch stays off until registered and baselined, and says why', async () => {
    const { service, send } = await rig()
    send(frames[0])
    await settle()
    expect(service.snapshot()).toMatchObject({ schema: 'SpatialFrame/v2', touchEnabled: false, reason: expect.stringMatching(/not registered/) })
    register(service)
    expect(service.snapshot()).toMatchObject({ touchEnabled: false, reason: expect.stringMatching(/baseline/) })
  })

  // Break caught: a touch without a projector position, or one off by the
  // registration (oracle: table mm / mm-per-px, computed here).
  it('a finger on the table: a candidate at once, at the right projector pixel', async () => {
    const { service, send, touches } = await baselined()
    expect(service.snapshot()).toMatchObject({ touchEnabled: true, lidar: { baseline: { state: 'ready' } } })
    const at = { x: 775, y: 400 }
    send(withFinger(frames[50], tableToSensor(at)))
    await settle()
    expect(touches.map((e) => e.type)).toEqual(['candidate'])
    expect(touches[0].projector!.x).toBeCloseTo(at.x / mmPerPx, -1)
    expect(touches[0].projector!.y).toBeCloseTo(at.y / mmPerPx, -1)
    expect(service.snapshot().lidar.touches).toHaveLength(1)
  })

  // Break caught: the projection's edge not applied. A person standing at
  // the near edge, 130 mm past the projection, is in the beam but not on
  // the table: no touch, no ripple.
  it('a finger past the projection edge is not a touch', async () => {
    const { send, touches } = await baselined()
    send(withFinger(frames[50], tableToSensor({ x: 775, y: 1100 })))
    send(withFinger(frames[51], tableToSensor({ x: 775, y: 1100 })))
    await settle()
    expect(touches).toEqual([])
  })

  // Break caught: a held touch staying "down" forever when the lidar goes
  // silent (no rotations = no misses = no up). It must cancel.
  it('silence cancels a live touch', async () => {
    const { send, touches } = await baselined()
    const at = { x: 600, y: 500 }
    send(withFinger(frames[50], tableToSensor(at)))
    send(withFinger(frames[51], tableToSensor(at)))
    await settle(600) // the source's stale threshold is 350 ms
    expect(touches.map((e) => e.type)).toEqual(['candidate', 'down', 'cancel'])
  })

  // Break caught: a re-registration leaving a touch to jump across the table
  // mid-gesture under the new map.
  it('a new registration cancels live touches', async () => {
    const { service, send, touches } = await baselined()
    send(withFinger(frames[50], tableToSensor({ x: 700, y: 300 })))
    await settle()
    register(service)
    expect(touches.map((e) => e.type)).toEqual(['candidate', 'cancel'])
  })
  // Break caught (Codex P2 on #90): clearing the baseline while a capture was
  // pending let the capture finish afterwards, re-install a baseline and turn
  // touch back on behind the operator's clear.
  it('clearing the baseline cancels a pending capture', async () => {
    const r = await rig()
    register(r.service)
    let i = 0
    const pump = setInterval(() => r.send(frames[i++ % 40]), 25)
    try {
      const pending = r.service.captureBaseline(600)
      await settle(300)
      r.service.clearBaseline()
      expect(await pending).toEqual({ ok: false, reason: expect.stringMatching(/cleared/i) })
      await settle(500) // past the capture's own deadline
      expect(r.service.snapshot()).toMatchObject({ touchEnabled: false, lidar: { baseline: { state: 'none' } } })
    } finally { clearInterval(pump) }
  })

  // Break caught (Codex P2 on #90): after a stale gap the resumed rotation was
  // associated with the tracks from before it (candidate, down, move: no
  // cancel), so a fresh tap near the old spot never rippled. The 50 ms health
  // timers are faked (never fire) and the clock is injected, so the only way
  // to see the gap is the frame's own receive time, as when the event loop was
  // busy through the silence.
  it('a rotation after a 1 s gap cancels old tracks before associating; a fresh tap ripples', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let clock = 0
    const server = new WebSocketServer({ port: 0 })
    let service: SpatialService | null = null
    try {
      await once(server, 'listening')
      service = createSpatialService({ lidarUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, now: () => clock })
      const [socket] = (await once(server, 'connection')) as [WebSocket]
      let t = Date.now()
      const send = async (f: LidarFrame, advance = 100) => {
        clock += advance
        socket.send(JSON.stringify({ t: (t += 100), points: f.points }))
        await settle(15)
      }
      const touches: SpatialTouchEvent[] = []
      service.onTouch((e) => touches.push(e))
      register(service)
      // Keep rotations coming until the capture's (real) deadline settles it.
      let done = false
      const capture = service.captureBaseline(800).finally(() => { done = true })
      for (let i = 0; !done; i++) await send(frames[i % 40], 25)
      const got = await capture
      expect(got, JSON.stringify(got)).toMatchObject({ ok: true })
      const at = tableToSensor({ x: 600, y: 500 })
      await send(withFinger(frames[50], at))
      await send(withFinger(frames[51], at))
      await send(withFinger(frames[52], at), 1000) // the gap: 1 s of silence, no timer ran
      await send(withFinger(frames[53], at))
      expect(touches.map((e) => e.type)).toEqual(['candidate', 'down', 'cancel', 'candidate', 'down'])
      expect(touches[3].id).not.toBe(touches[0].id)
      expect(touchLineFor(touches[3])).toMatchObject({ kind: 'touch', phase: 'down' })
    } finally {
      service?.stop()
      vi.useRealTimers()
      for (const ws of server.clients) ws.terminate()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
