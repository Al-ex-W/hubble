import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { createSpatialService } from './service.ts'
import { streamSpatial } from './stream.ts'
import type { SpatialFrame } from './frame.ts'

afterEach(() => vi.useRealTimers())

it('bounds a blocked stream to its in-flight frame plus latest state, then drains in order', async () => {
  // Contract probe through a real Node stream with deliberate backpressure.
  // A slow observer must not queue the whole hand/lidar history or delay input.
  const s = createSpatialService({ now: () => 0 })
  const sink = new PassThrough({ highWaterMark: 1 })
  const seen: SpatialFrame[] = []
  try {
    streamSpatial(s, sink)
    for (let i = 1; i <= 100; i++) s.observe({ session: 'probe', seq: i, capturedAt: i, geometry: 'probe', width: 10, height: 10, hands: [] })
    sink.on('data', (chunk: Buffer) => seen.push(JSON.parse(chunk.toString().split('\n').find(l => l.startsWith('data: '))!.slice(6))))
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[0]!.camera.frame).toBeNull()
    expect(seen[1]!.camera.frame?.seq).toBe(100)
    s.stop()
    await vi.waitFor(() => expect(sink.writableEnded).toBe(true))
    expect(seen.at(-1)!.state).toBe('stopped')
  } finally { s.stop(); sink.destroy() }
})

it('disconnects a permanently stalled stream and accepts a latest-state reconnect', async () => {
  // Contract probe: otherwise a departed client retains a listener and a frame
  // forever. Reconnect is a new snapshot, never a replay of old hand actions.
  vi.useFakeTimers()
  const s = createSpatialService({ now: () => 0 })
  const stuck = new PassThrough({ highWaterMark: 1 })
  const fresh = new PassThrough()
  try {
    streamSpatial(s, stuck)
    await vi.advanceTimersByTimeAsync(5001)
    expect(stuck.destroyed).toBe(true)
    expect(stuck.listenerCount('drain')).toBe(0)
    s.observe({ session: 'probe', seq: 8, capturedAt: 8, geometry: 'probe', width: 10, height: 10, hands: [] })
    const chunks: Buffer[] = []
    fresh.on('data', b => chunks.push(b))
    streamSpatial(s, fresh)
    expect(chunks).toHaveLength(1)
    expect(JSON.parse(chunks[0]!.toString().split('\n').find(l => l.startsWith('data: '))!.slice(6))).toEqual(s.snapshot())
    fresh.destroy()
    await vi.advanceTimersByTimeAsync(1)
    expect(fresh.listenerCount('drain')).toBe(0)
  } finally { s.stop(); stuck.destroy(); fresh.destroy() }
})

it('still disconnects a stalled writer after the final shutdown frame', async () => {
  // Contract probe: end() alone does not release a blocked socket. Clearing
  // the deadline while writing the last frame kept a stopped service retained.
  vi.useFakeTimers()
  const s = createSpatialService({ now: () => 0 })
  s.stop()
  const sink = new PassThrough({ highWaterMark: 1 })
  streamSpatial(s, sink)
  await vi.advanceTimersByTimeAsync(5001)
  expect(sink.destroyed).toBe(true)
  expect(sink.listenerCount('drain')).toBe(0)
})
