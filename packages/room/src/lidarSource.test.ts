import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { createLidarSource, createLidarStream, type LidarFrame } from './lidarSource.ts'
import { MAX_LIDAR_BYTES, MAX_LIDAR_POINTS, parseLidarScan } from './spec.ts'

const bytes = readFileSync(new URL('../fixtures/lidar/2026-10-07-wire/scans.jsonl', import.meta.url))
const rows: { receivedAt: number; raw: string }[] = bytes.toString().trim().split('\n').map(l => JSON.parse(l))
const first = JSON.parse(rows[0].raw)

describe('recorded per-Pi lidar source', () => {
  it('preserves every recorded return, including zero and beyond nominal range', () => {
    // Break caught: filtering optical range in the decoder changes the evidence
    // before calibration sees it. Counts/hash are independent capture census.
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('3ab8ea3b33019f855568e73c09ff53e5334d27ca6716c93b29f761b0b1618084')
    expect(rows).toHaveLength(116)
    const frames: LidarFrame[] = []
    let now = 0
    const stream = createLidarStream({ now: () => now, onFrame: f => frames.push(f) })
    stream.connected('recording')
    for (const r of rows) { now = r.receivedAt - rows[0].receivedAt; stream.receive(r.raw) }
    expect(frames).toHaveLength(116)
    expect(frames.flatMap(f => f.points)).toHaveLength(59044)
    expect(frames.flatMap(f => f.points).filter(p => p.distance > 0)).toHaveLength(36305)
    expect(frames.map(f => f.sourceTimeMs)).toEqual(rows.map(r => JSON.parse(r.raw).t))
    expect(frames.every(f => f.acquisitionAgeMs === null)).toBe(true)
  })

  it('does not refresh progress from repeated, backwards or malformed scans', () => {
    // Mechanical mutations of scan 1. Removing the progress guard turns a
    // frozen device into a healthy one; removing age checking hides silence.
    let now = 0
    const frames: LidarFrame[] = []
    const stream = createLidarStream({ now: () => now, onFrame: f => frames.push(f) })
    stream.connected('one')
    stream.receive(rows[0].raw)
    now = 400
    stream.receive(rows[0].raw)
    stream.receive(JSON.stringify({ ...first, t: first.t - 1 }))
    stream.receive('{')
    expect(frames).toHaveLength(1)
    expect(stream.snapshot()).toMatchObject({ state: 'stale', nonProgressing: 2, malformed: 1, lastFrameAtMonoMs: 0 })
    stream.disconnected()
    stream.receive(rows[1].raw)
    expect(frames).toHaveLength(1)
    stream.connected('two')
    expect(stream.snapshot().state).toBe('awaiting-scan')
    stream.receive(rows[0].raw)
    expect(frames[1]).toMatchObject({ sourceSession: 'two', seq: 1 })
    stream.stop()
    stream.connected('late')
    stream.receive(rows[1].raw)
    expect(frames).toHaveLength(2)
    expect(stream.snapshot().state).toBe('stopped')
  })

  it('rejects malformed and unbounded mechanical mutations without throwing', () => {
    // Break caught: accepting bad coordinates poisons downstream transforms;
    // wire-size bounds prevent a peer from allocating unbounded evidence.
    const badPoints = [{ ...first.points[0], angle: 360 }, { ...first.points[0], angle: -1 },
      { ...first.points[0], distance: -1 }, { ...first.points[0], quality: 64 },
      { ...first.points[0], quality: .5 }, { ...first.points[0], angle: '12' }, null]
    for (const p of badPoints) expect(parseLidarScan(JSON.stringify({ ...first, points: [p] }))).toBeNull()
    expect(parseLidarScan(JSON.stringify({ ...first, points: Array(MAX_LIDAR_POINTS + 1).fill(first.points[0]) }))).toBeNull()
    expect(parseLidarScan(' '.repeat(MAX_LIDAR_BYTES) + rows[0].raw)).toBeNull()
    expect(parseLidarScan(JSON.stringify({ ...first, t: null }))).toBeNull()
    expect(parseLidarScan('null')).toBeNull()
  })

  it('connects to /scan independently of metadata and reports silence and stop', async () => {
    // Recorded payload over a schema-derived loopback endpoint. A regression to
    // /api/lidar/scan fails here without needing the venue Wi-Fi in CI.
    const wss = new WebSocketServer({ port: 0, path: '/scan' })
    await once(wss, 'listening')
    const address = wss.address() as { port: number }
    let received!: (f: LidarFrame) => void
    const frame = new Promise<LidarFrame>(r => { received = r })
    let stale!: () => void
    const silent = new Promise<void>(r => { stale = r })
    wss.on('connection', ws => ws.send(rows[0].raw))
    const source = createLidarSource({ url: `http://127.0.0.1:${address.port}`, staleMs: 50,
      onFrame: received, onHealth: h => { if (h.state === 'stale') stale() } })
    try {
      expect((await frame).points).toEqual(first.points)
      await silent
      expect(source.snapshot().state).toBe('stale')
    } finally {
      source.stop()
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>(r => wss.close(() => r()))
    }
    expect(source.snapshot().state).toBe('stopped')
  })
})
