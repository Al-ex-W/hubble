import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SURFACE, type OverlayLine } from '@hubble/stage'
import type { LidarFrame } from '@hubble/room'
import { createSpatialService } from './service.ts'
import { createLidarRegistration } from './lidarWizard.ts'
import { tableToSensor, wireFrames, withFinger } from './lidarFixtures.ts'
import { LIDAR_TARGET_LAYER } from '../../shared/lidarTarget.ts'
import { mountRuntime } from '../runtimeRoutes.ts'
import type { Runtime } from '../runtime.ts'

/*
 * The wizard end to end through POST /api/spatial/registration/run: a
 * loopback socket (the pool never gates loopback) streams the real wire
 * rotations (recording); whenever a target is on the overlay, a finger is put
 * into every rotation at that target's sensor position (mechanical mutation,
 * withFinger, as #90's tests). The lidar pose is lidarFixtures' schema-derived
 * one. Oracle: the installed map sends each target's sensor point back to the
 * target's table mm, computed here as px × mm/px, never the wizard's helpers.
 */
const frames = wireFrames()
const mmPerPx = DEFAULT_SURFACE.mmPerPx
let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

const centroid = (pts: { x: number; y: number }[]) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length })

async function rig() {
  const wss = new WebSocketServer({ port: 0 })
  await once(wss, 'listening')
  const spatial = createSpatialService({ lidarUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}` })
  const [socket] = (await once(wss, 'connection')) as [WebSocket]
  let t = Date.now()
  // Where the synthetic finger is: set by the overlay (the person puts it
  // where the light is), removed when the target clears.
  let finger: { x: number; y: number } | null = null
  const lines: OverlayLine[] = []
  let i = 0
  const pump = setInterval(() => {
    const f: LidarFrame = frames[i++ % 40]!
    socket.send(JSON.stringify({ t: (t += 100), points: (finger ? withFinger(f, finger) : f).points }))
  }, 25)
  const wizard = createLidarRegistration({
    overlay: (line) => {
      lines.push(line)
      if (line.layer !== LIDAR_TARGET_LAYER) return
      if (!line.shapes.length) return void (finger = null)
      const px = centroid(line.shapes[0]!.points)
      finger = tableToSensor({ x: px.x * mmPerPx, y: px.y * mmPerPx })
    },
    spatial,
    mayProject: () => true,
    holdMs: 300,
    timeoutMs: 5000,
  })
  const app = express()
  app.use(express.json())
  mountRuntime(app, { lidarRegistration: wizard } as unknown as Runtime)
  const server = app.listen(0)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanup = async () => {
    clearInterval(pump)
    spatial.stop()
    server.close()
    for (const ws of wss.clients) ws.terminate()
    await new Promise<void>((r) => wss.close(() => r()))
  }
  return { spatial, wizard, base, lines }
}

describe('lidar registration wizard', () => {
  // Break caught: the run not installing a registration (or installing one
  // that maps the finger somewhere other than the dot it was held on), and a
  // target left on the projector after the run.
  it('six held fingers → registration installed, touch on, target cleared', async () => {
    const { spatial, base, lines } = await rig()
    expect((await spatial.captureBaseline(1000)).ok).toBe(true)
    const res = await fetch(`${base}/api/spatial/registration/run`, { method: 'POST' })
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ phase: 'done', captured: expect.any(Array) })
    expect(body.captured).toHaveLength(6)
    const snap = spatial.snapshot()
    expect(snap.calibration.registration).not.toBeNull()
    expect(snap.touchEnabled).toBe(true)
    // The installed map takes the centre target's sensor point to its table mm (±25 mm).
    const at = { x: 960 * mmPerPx, y: 600 * mmPerPx }
    const got = spatial.calibration.lidarToTable(tableToSensor(at))!
    expect(Math.hypot(got.x - at.x, got.y - at.y)).toBeLessThan(25)
    expect(lines.at(-1)).toMatchObject({ layer: LIDAR_TARGET_LAYER, shapes: [] })
    expect((await (await fetch(`${base}/api/spatial/registration/run`)).json()).phase).toBe('done')
  }, 30_000)

  // Break caught: fail closed. No baseline → refused before any target is
  // projected, and nothing installed.
  it('refuses without a baseline and leaves touch off', async () => {
    const { spatial, base, lines } = await rig()
    const res = await fetch(`${base}/api/spatial/registration/run`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/baseline/)
    expect(lines.filter((l) => l.shapes.length)).toEqual([])
    expect(spatial.snapshot().touchEnabled).toBe(false)
  })
})
