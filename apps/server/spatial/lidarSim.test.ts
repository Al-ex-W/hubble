import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import type { Pose } from '@hubble/room'
import { DEFAULT_SURFACE } from '@hubble/stage'
import { buildBaseline, foreground } from './baseline.ts'
import { clusters } from './touch.ts'
import { createLidarSim, pxToSensor, SIM_DEFAULT_POSE, simulatedRotation } from './lidarSim.ts'
import { mountSimLidar } from './simRoutes.ts'
import { createSpatialService } from './service.ts'

/*
 * Provenance: SYNTHETIC. The lidar here is packages/room/src/simulate.ts's C1
 * model (the room emulator's), because the thing under test IS the simulation.
 * Oracles are independent trig written in this file (bearing = atan2, reported
 * angle = bearing - rotation), never pxToSensor/sensorToTable.
 */
const mm = DEFAULT_SURFACE.mmPerPx
const POSES: Pose[] = [SIM_DEFAULT_POSE, { x: 300, y: -40, rotation: 20 }, { x: 1200, y: 10, rotation: 130, mirrored: true }]

/** Where a C1 at `pose` reports a thing at table mm `t`: bearing from the pose, minus the mount's rotation (plus the mirror), as polar → Cartesian. */
function oracleSensor(t: { x: number; y: number }, pose: Pose) {
  const bearing = (Math.atan2(t.y - pose.y, t.x - pose.x) * 180) / Math.PI
  const a = ((pose.mirrored ? pose.rotation - bearing : bearing - pose.rotation) * Math.PI) / 180
  const d = Math.hypot(t.x - pose.x, t.y - pose.y)
  return { x: d * Math.cos(a), y: d * Math.sin(a) }
}

describe('simulated lidar geometry', () => {
  // Break caught: the px → sensor conversion wrong (a transposed rotation, a
  // forgotten mirror, px used as mm): every simulated touch then lands
  // somewhere the owner did not click, and the wizard would "recover" a
  // pose that is not the virtual one.
  it('pxToSensor agrees with independent trig for three mounts', () => {
    for (const pose of POSES)
      for (const px of [{ x: 960, y: 600 }, { x: 150, y: 150 }, { x: 1770, y: 1050 }, { x: 960, y: 150 }]) {
        const want = oracleSensor({ x: px.x * mm, y: px.y * mm }, pose)
        const got = pxToSensor(px, pose)
        expect(Math.hypot(got.x - want.x, got.y - want.y), JSON.stringify({ pose, px })).toBeLessThan(0.01)
      }
  })

  // Break caught: the synthesized rotation not putting the finger where the
  // pose says (or splitting/dropping it): the real clusterer on the real
  // background subtraction must find exactly ONE finger-sized cluster within
  // a range step of the oracle position, for every phase of the angle grid.
  it('a rotation with a finger yields one cluster at the oracle sensor position', () => {
    for (const pose of POSES) {
      const empty = Array.from({ length: 30 }, (_, i) => ({ sourceSession: 's', seq: i, sourceTimeMs: i, receivedAtMonoMs: i, acquisitionAgeMs: null, points: simulatedRotation(null, pose, i + 1, i).points }))
      const base = buildBaseline(empty)
      expect(base.ok).toBe(true)
      if (!base.ok) return
      for (const px of [{ x: 960, y: 600 }, { x: 150, y: 1050 }, { x: 1770, y: 150 }])
        for (let seq = 100; seq < 108; seq++) {
          const found = clusters(foreground(simulatedRotation(px, pose, seq, seq).points, base.baseline), (s) => s, () => true)
          expect(found, JSON.stringify({ pose, px, seq })).toHaveLength(1)
          const want = oracleSensor({ x: px.x * mm, y: px.y * mm }, pose)
          expect(Math.hypot(found[0]!.sensor.x - want.x, found[0]!.sensor.y - want.y), JSON.stringify({ pose, px, seq })).toBeLessThan(30)
        }
    }
  })
})

describe('simulated lidar on the spatial service', () => {
  // Break caught: a sim attached beside a real lidar. One service holding two
  // scan sources would mix a simulated finger into a real table's baseline.
  it('is refused while a real lidar is configured', () => {
    const real = createSpatialService({ lidarUrl: 'http://127.0.0.1:9' })
    try {
      const r = real.attachSim(() => ({ snapshot: () => ({}) as never, stop() {} }))
      expect(r.ok).toBe(false)
      expect(real.simAttached()).toBe(false)
    } finally {
      real.stop()
    }
  })

  // Break caught: a sim run overwriting or deleting the REAL room's saved
  // registration file (the file is kept across restarts on purpose).
  // Driven through the same pointer path the page uses; a sentinel stands in
  // for the saved file.
  it('registers in memory only: the registration file is never written or removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubble-sim-'))
    const file = join(dir, 'registration.json')
    writeFileSync(file, 'REAL-ROOM-SENTINEL')
    const spatial = createSpatialService({ registrationFile: file })
    const sim = createLidarSim({ spatial, manual: true, now: () => 0 })
    try {
      expect(sim.enable().ok).toBe(true)
      spatial.calibration.register({
        table: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }].map((p) => ({ from: p, to: { x: p.x / mm, y: p.y / mm } })),
        tableCheck: [{ x: 500, y: 500 }, { x: 250, y: 750 }].map((p) => ({ from: p, to: { x: p.x / mm, y: p.y / mm } })),
        lidar: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }].map((p) => ({ from: p, to: p })),
        lidarCheck: [{ x: 500, y: 500 }, { x: 250, y: 750 }].map((p) => ({ from: p, to: p })),
        maxProjectorErrorPx: 1,
        maxTableErrorMm: 1,
      })
      expect(spatial.snapshot().calibration.registration).not.toBeNull()
      expect(readFileSync(file, 'utf8')).toBe('REAL-ROOM-SENTINEL')
      sim.reset()
      // Leaving sim mode drops the virtual registration, and the file is still the real one.
      expect(spatial.snapshot().calibration.registration).toBeNull()
      expect(readFileSync(file, 'utf8')).toBe('REAL-ROOM-SENTINEL')
    } finally {
      spatial.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('simulated pointer rules', () => {
  const rig = async (now = { t: 0 }) => {
    const spatial = createSpatialService()
    const sim = createLidarSim({ spatial, manual: true, now: () => now.t, pointerIdleMs: 1000 })
    const app = express()
    app.use(express.json())
    mountSimLidar(app, sim, 'unavailable')
    const server = app.listen(0)
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { spatial, sim, post, close: () => { spatial.stop(); server.close() } }
  }

  // Break caught: a finger that can be put down while the sim is off (it would
  // appear later out of nowhere), two simultaneous fingers, a move from a
  // finger that was never down, and a px outside the projector.
  it('one pointer at a time, only while rotating, only inside the projector', async () => {
    const now = { t: 0 }
    const r = await rig(now)
    try {
      const down = (id: string, x = 100, y = 100) => r.post('/api/spatial/sim/pointer', { id, phase: 'down', px: { x, y } })
      expect((await down('a')).status).toBe(409) // sim not started
      expect((await r.post('/api/spatial/sim', { action: 'start' })).status).toBe(200)
      expect((await down('a')).status).toBe(200)
      expect((await down('b')).status).toBe(409) // another finger is down
      expect((await r.post('/api/spatial/sim/pointer', { id: 'b', phase: 'move', px: { x: 1, y: 1 } })).status).toBe(409)
      expect((await down('a', 5000, 5)).status).toBe(409) // outside 1920 × 1200
      expect((await r.post('/api/spatial/sim/pointer', { id: 'a', phase: 'down' })).status).toBe(400) // px missing
      expect((await r.post('/api/spatial/sim/pointer', { id: 'a', phase: 'sideways', px: { x: 1, y: 1 } })).status).toBe(400)
      // The tab died with the finger down: it is released, and a new finger can come.
      now.t += 1500
      expect((await down('b')).status).toBe(200)
      expect(r.sim.state().pointer?.id).toBe('b')
      await r.post('/api/spatial/sim/pointer', { id: 'b', phase: 'up' })
      expect(r.sim.state().pointer).toBeNull()
    } finally {
      r.close()
    }
  })

  // Break caught: the routes pretending a sim exists where none may run.
  it('says why when no sim may run, with 409', async () => {
    const app = express()
    app.use(express.json())
    mountSimLidar(app, null, 'a real lidar is configured')
    const server = app.listen(0)
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      expect(await (await fetch(`${base}/api/spatial/sim`)).json()).toEqual({ available: false, reason: 'a real lidar is configured' })
      const p = await fetch(`${base}/api/spatial/sim/pointer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'a', phase: 'down', px: { x: 1, y: 1 } }) })
      expect(p.status).toBe(409)
    } finally {
      server.close()
    }
  })
})
