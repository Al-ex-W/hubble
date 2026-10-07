import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { expect, it, vi } from 'vitest'
import { createSpatialService } from './service.ts'
import type { SpatialFrame } from './frame.ts'

it('never presents stale raw observations as calibrated touch evidence', async () => {
  // Recording provenance: unchanged first rotation of the 116-scan wire take.
  // Removing the health guard leaves an old hand visible after sensor silence;
  // diagnostic receipt alone must never enable the keyboard.
  const raw = JSON.parse(readFileSync(new URL('../../../packages/room/fixtures/lidar/2026-10-07-wire/scans.jsonl', import.meta.url), 'utf8').split('\n')[0]).raw
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const service = createSpatialService({ lidarUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  try {
    const [socket] = await once(server, 'connection')
    socket.send(raw)
    await new Promise((r) => setTimeout(r, 30))
    expect(service.snapshot()).toMatchObject({ calibrated: false, touchEnabled: false, lidar: { health: { state: 'receiving' } } })
    expect(service.snapshot().lidar.frame).not.toBeNull()
    await new Promise((r) => setTimeout(r, 400))
    expect(service.snapshot().lidar.frame).toBeNull()
    service.stop()
    expect(service.snapshot().lidar.frame).toBeNull()
  } finally {
    service.stop()
    for (const ws of server.clients) ws.terminate()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

it('reconciles all recorded scans and keeps source clocks, registration revisions and expiry distinct', async () => {
  // Recording: all 116 unchanged raw wire scans, including invalid ranges.
  // Schema-derived registration uses plain affine arithmetic as the oracle.
  // This is independent-stream interleaving, NOT a paired physical recording.
  const take = readFileSync(new URL('../../../packages/room/fixtures/lidar/2026-10-07-wire/scans.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(take).toHaveLength(116)
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  let time = 0
  const s = createSpatialService({ lidarUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, now: () => time })
  const frames: SpatialFrame[] = []
  s.subscribe(f => frames.push(f))
  const corners = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 500 }, { x: 0, y: 500 }]
  const checks = [{ x: 250, y: 125 }, { x: 750, y: 375 }]
  const table = (ps: typeof corners) => ps.map(from => ({ from, to: { x: from.x * 2 + 10, y: from.y * 2 + 20 } }))
  const lidar = (ps: typeof corners) => ps.map(from => ({ from, to: { x: from.x + 50, y: from.y + 100 } }))
  try {
    const [socket] = await once(server, 'connection')
    s.calibration.register({ table: table(corners), tableCheck: table(checks), lidar: lidar(corners), lidarCheck: lidar(checks), maxProjectorErrorPx: 1, maxTableErrorMm: 1 })
    s.calibration.setCamera({ h: [1, 0, 0, 0, 1, 0, 0, 0, 1], width: 1920, height: 1080, geometry: 'probe' })
    let positives = 0
    let points = 0
    for (let i = 0; i < take.length; i++) {
      time = i * 10 // server receipt clock intentionally unlike the Pi epoch
      if (i % 20 === 0) s.observe({ session: 'probe', seq: i, capturedAt: i + 1, geometry: 'probe', width: 1920, height: 1080, hands: [{ index: { x: 510, y: 420 } }] })
      socket.send(take[i].raw)
      await vi.waitFor(() => expect(s.snapshot().lidar.frame?.seq).toBe(i + 1), { interval: 1 })
      const frame = frames.at(-1)!
      expect(frame).toEqual(s.snapshot())
      points += frame.lidar.frame!.points.length
      positives += frame.lidar.returns.length
      expect(frame.lidar.frame!.sourceTimeMs).toBe(JSON.parse(take[i].raw).t)
      expect(frame.lidar.frame!.receivedAtMonoMs).toBe(time)
      expect(frame.lidar.frame!.acquisitionAgeMs).toBeNull()
      expect(frame.camera.fingers[0]!.table!.x).toBeCloseTo(250)
      expect(frame.camera.fingers[0]!.contact).toBe('unknown')
      for (const p of frame.lidar.returns) {
        expect(p.table!.x).toBeCloseTo(p.sensor.x + 50)
        expect(p.projector!.y).toBeCloseTo((p.sensor.y + 100) * 2 + 20)
      }
    }
    expect(points).toBe(59044)
    expect(positives).toBe(36305)
    // A calibration revision must invalidate existing evidence synchronously,
    // not remap the previous scan under an unrelated new physical registration.
    s.calibration.clearRegistration()
    expect(frames.at(-1)!.lidar.returns).toEqual([])
    expect(frames.at(-1)!.camera.fingers).toEqual([])
    time += 501
    await vi.waitFor(() => expect(frames.at(-1)!.lidar.health?.state).toBe('stale'))
    expect(frames.at(-1)!.lidar.frame).toBeNull()
    s.stop()
    expect(frames.at(-1)!.state).toBe('stopped')
  } finally {
    s.stop()
    for (const ws of server.clients) ws.terminate()
    await new Promise<void>(r => server.close(() => r()))
  }
})
